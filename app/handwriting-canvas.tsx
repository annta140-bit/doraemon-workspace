"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

import {
  LOGICAL_PAGE_HEIGHT,
  LOGICAL_PAGE_WIDTH,
  makeId,
  type CanvasTool,
  type Stroke,
  type StrokePoint,
} from "./workspace-model";

const MAX_DEVICE_PIXEL_RATIO = 2;
const MIN_POINT_DISTANCE = 1.5;

const canvasStyle: CSSProperties = {
  display: "block",
  width: "100%",
  height: "100%",
};

type PageTransform = {
  scale: number;
  offsetX: number;
  offsetY: number;
};

export type HandwritingCanvasProps = {
  noteId: string;
  strokes: Stroke[];
  legacyDrawing?: string;
  tool: CanvasTool;
  ink: string;
  penOnly: boolean;
  onStrokeStart?: (noteId: string) => void;
  onAddStroke: (noteId: string, stroke: Stroke) => void;
};

export type DrawingPreviewProps = {
  strokes: Stroke[];
  legacyDrawing?: string;
  className?: string;
};

function pageTransform(width: number, height: number): PageTransform {
  const scale = Math.min(width / LOGICAL_PAGE_WIDTH, height / LOGICAL_PAGE_HEIGHT);
  return {
    scale,
    offsetX: (width - LOGICAL_PAGE_WIDTH * scale) / 2,
    offsetY: (height - LOGICAL_PAGE_HEIGHT * scale) / 2,
  };
}

function pressureMultiplier(point: StrokePoint) {
  if (typeof point.pressure !== "number") return 1;
  return 0.62 + point.pressure * 0.72;
}

function drawStroke(context: CanvasRenderingContext2D, stroke: Stroke) {
  const points = stroke.points;
  if (!points.length) return;

  context.save();
  context.globalCompositeOperation = stroke.tool === "eraser" ? "destination-out" : "source-over";
  context.globalAlpha = stroke.opacity;
  context.strokeStyle = stroke.color;
  context.fillStyle = stroke.color;
  context.lineCap = "round";
  context.lineJoin = "round";

  if (points.length === 1) {
    const width = stroke.tool === "pen"
      ? stroke.width * pressureMultiplier(points[0])
      : stroke.width;
    context.beginPath();
    context.arc(points[0].x, points[0].y, width / 2, 0, Math.PI * 2);
    context.fill();
    context.restore();
    return;
  }

  if (stroke.tool !== "pen") {
    context.lineWidth = stroke.width;
    context.beginPath();
    context.moveTo(points[0].x, points[0].y);
    for (let index = 1; index < points.length; index += 1) {
      context.lineTo(points[index].x, points[index].y);
    }
    context.stroke();
    context.restore();
    return;
  }

  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    context.lineWidth = stroke.width * (pressureMultiplier(previous) + pressureMultiplier(current)) / 2;
    context.beginPath();
    context.moveTo(previous.x, previous.y);
    context.lineTo(current.x, current.y);
    context.stroke();
  }
  context.restore();
}

function renderCanvas(
  canvas: HTMLCanvasElement,
  strokes: readonly Stroke[],
  legacyImage: HTMLImageElement | null,
) {
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;

  const pixelRatio = Math.min(window.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO);
  const pixelWidth = Math.max(1, Math.round(rect.width * pixelRatio));
  const pixelHeight = Math.max(1, Math.round(rect.height * pixelRatio));
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }

  const context = canvas.getContext("2d");
  if (!context) return;

  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);

  const transform = pageTransform(rect.width, rect.height);
  context.setTransform(
    pixelRatio * transform.scale,
    0,
    0,
    pixelRatio * transform.scale,
    pixelRatio * transform.offsetX,
    pixelRatio * transform.offsetY,
  );

  if (legacyImage) {
    context.drawImage(legacyImage, 0, 0, LOGICAL_PAGE_WIDTH, LOGICAL_PAGE_HEIGHT);
  }
  for (const stroke of strokes) drawStroke(context, stroke);
}

function renderStrokeIncrement(canvas: HTMLCanvasElement, stroke: Stroke, previousPointCount: number) {
  if (stroke.points.length <= previousPointCount) return;
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  const context = canvas.getContext("2d");
  if (!context) return;
  const pixelRatio = Math.min(window.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO);
  const transform = pageTransform(rect.width, rect.height);
  context.setTransform(
    pixelRatio * transform.scale,
    0,
    0,
    pixelRatio * transform.scale,
    pixelRatio * transform.offsetX,
    pixelRatio * transform.offsetY,
  );
  drawStroke(context, {
    ...stroke,
    points: stroke.points.slice(Math.max(0, previousPointCount - 1)),
  });
}

function useCanvasRenderer(
  strokes: readonly Stroke[],
  legacyDrawing: string | undefined,
  activeStrokeRef?: RefObject<Stroke | null>,
  skipStrokeRenderRef?: RefObject<string | null>,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokesRef = useRef(strokes);
  const legacyDrawingRef = useRef(legacyDrawing);
  const legacyImageRef = useRef<HTMLImageElement | null>(null);
  const loadedLegacySourceRef = useRef<string | undefined>(undefined);

  strokesRef.current = strokes;
  legacyDrawingRef.current = legacyDrawing;

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const legacyImage = loadedLegacySourceRef.current === legacyDrawingRef.current
      ? legacyImageRef.current
      : null;
    const activeStroke = activeStrokeRef?.current;
    renderCanvas(
      canvas,
      activeStroke ? [...strokesRef.current, activeStroke] : strokesRef.current,
      legacyImage,
    );
  }, [activeStrokeRef]);

  useLayoutEffect(() => {
    const lastStrokeId = strokes.at(-1)?.id;
    if (skipStrokeRenderRef?.current && skipStrokeRenderRef.current === lastStrokeId) {
      skipStrokeRenderRef.current = null;
      return;
    }
    if (skipStrokeRenderRef) skipStrokeRenderRef.current = null;
    redraw();
  }, [strokes, legacyDrawing, redraw, skipStrokeRenderRef]);

  useEffect(() => {
    legacyImageRef.current = null;
    loadedLegacySourceRef.current = undefined;
    redraw();
    if (!legacyDrawing) return undefined;

    let cancelled = false;
    const image = new Image();
    image.onload = () => {
      if (cancelled) return;
      legacyImageRef.current = image;
      loadedLegacySourceRef.current = legacyDrawing;
      redraw();
    };
    image.onerror = () => {
      if (!cancelled) redraw();
    };
    image.src = legacyDrawing;

    return () => {
      cancelled = true;
    };
  }, [legacyDrawing, redraw]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const observer = new ResizeObserver(redraw);
    observer.observe(canvas);
    redraw();
    return () => observer.disconnect();
  }, [redraw]);

  return { canvasRef, redraw };
}

function logicalPoint(
  pointer: PointerEvent,
  canvas: HTMLCanvasElement,
  requireInsidePage: boolean,
): StrokePoint | null {
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;

  const transform = pageTransform(rect.width, rect.height);
  if (transform.scale <= 0) return null;
  const rawX = (pointer.clientX - rect.left - transform.offsetX) / transform.scale;
  const rawY = (pointer.clientY - rect.top - transform.offsetY) / transform.scale;
  if (
    requireInsidePage
    && (rawX < 0 || rawX > LOGICAL_PAGE_WIDTH || rawY < 0 || rawY > LOGICAL_PAGE_HEIGHT)
  ) return null;

  return {
    x: Math.round(Math.max(0, Math.min(LOGICAL_PAGE_WIDTH, rawX)) * 10) / 10,
    y: Math.round(Math.max(0, Math.min(LOGICAL_PAGE_HEIGHT, rawY)) * 10) / 10,
    pressure: pointer.pressure > 0 ? Math.round(Math.max(0, Math.min(1, pointer.pressure)) * 100) / 100 : 0.5,
  };
}

function pointerSamples(event: ReactPointerEvent<HTMLCanvasElement>) {
  const nativeEvent = event.nativeEvent;
  const samples = typeof nativeEvent.getCoalescedEvents === "function"
    ? nativeEvent.getCoalescedEvents()
    : [];
  return samples.length ? samples : [nativeEvent];
}

function appendPoint(stroke: Stroke, point: StrokePoint, force = false) {
  const previous = stroke.points.at(-1);
  if (!previous) {
    stroke.points.push(point);
    return;
  }
  const deltaX = point.x - previous.x;
  const deltaY = point.y - previous.y;
  const distanceSquared = deltaX * deltaX + deltaY * deltaY;
  if (
    distanceSquared >= MIN_POINT_DISTANCE * MIN_POINT_DISTANCE
    || (force && distanceSquared > Number.EPSILON)
  ) {
    stroke.points.push(point);
  }
}

function strokeStyle(tool: CanvasTool, ink: string) {
  switch (tool) {
    case "marker":
      return { color: ink, width: 22, opacity: 0.24 };
    case "eraser":
      return { color: "#000000", width: 38, opacity: 1 };
    default:
      return { color: ink, width: 4, opacity: 1 };
  }
}

export function HandwritingCanvas({
  noteId,
  strokes,
  legacyDrawing,
  tool,
  ink,
  penOnly,
  onStrokeStart,
  onAddStroke,
}: HandwritingCanvasProps) {
  const activeStrokeRef = useRef<Stroke | null>(null);
  const activePointerIdRef = useRef<number | null>(null);
  const activeNoteIdRef = useRef<string | null>(null);
  const onStrokeStartRef = useRef(onStrokeStart);
  const onAddStrokeRef = useRef(onAddStroke);
  const skipStrokeRenderRef = useRef<string | null>(null);
  const { canvasRef, redraw } = useCanvasRenderer(strokes, legacyDrawing, activeStrokeRef, skipStrokeRenderRef);
  onStrokeStartRef.current = onStrokeStart;
  onAddStrokeRef.current = onAddStroke;

  const addSamples = useCallback((event: ReactPointerEvent<HTMLCanvasElement>, forceLast = false) => {
    const activeStroke = activeStrokeRef.current;
    if (!activeStroke) return null;
    const previousPointCount = activeStroke.points.length;
    const samples = pointerSamples(event);
    samples.forEach((sample, index) => {
      const point = logicalPoint(sample, event.currentTarget, false);
      if (point) appendPoint(activeStroke, point, forceLast && index === samples.length - 1);
    });
    return { stroke: activeStroke, previousPointCount };
  }, []);

  const startStroke = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (activePointerIdRef.current !== null) return;
    if (penOnly && event.pointerType !== "pen") return;

    const point = logicalPoint(event.nativeEvent, event.currentTarget, true);
    if (!point) return;
    event.preventDefault();
    onStrokeStartRef.current?.(noteId);

    const style = strokeStyle(tool, ink);
    activePointerIdRef.current = event.pointerId;
    activeNoteIdRef.current = noteId;
    activeStrokeRef.current = {
      id: makeId("stroke"),
      tool,
      color: style.color,
      width: style.width,
      opacity: style.opacity,
      points: [point],
    };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Some WebKit versions can reject capture while the pointer is transitioning.
    }
    if (activeStrokeRef.current) renderStrokeIncrement(event.currentTarget, activeStrokeRef.current, 0);
  }, [ink, noteId, penOnly, tool]);

  const continueStroke = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (activePointerIdRef.current !== event.pointerId) return;
    event.preventDefault();
    const added = addSamples(event);
    if (added) renderStrokeIncrement(event.currentTarget, added.stroke, added.previousPointCount);
  }, [addSamples]);

  const finishStroke = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (activePointerIdRef.current !== event.pointerId) return;
    event.preventDefault();
    const added = addSamples(event, true);
    if (added) renderStrokeIncrement(event.currentTarget, added.stroke, added.previousPointCount);

    const completedStroke = activeStrokeRef.current;
    const completedNoteId = activeNoteIdRef.current;
    activeStrokeRef.current = null;
    activePointerIdRef.current = null;
    activeNoteIdRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (completedStroke?.points.length && completedNoteId) {
      // Incremental marker segments overlap with partial opacity at their joins,
      // so redraw that tool once as a single path after it is committed.
      skipStrokeRenderRef.current = completedStroke.tool === "marker" ? null : completedStroke.id;
      onAddStrokeRef.current(completedNoteId, completedStroke);
    }
  }, [addSamples]);

  const cancelStroke = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (activePointerIdRef.current !== event.pointerId) return;
    const completedStroke = activeStrokeRef.current;
    const completedNoteId = activeNoteIdRef.current;
    activeStrokeRef.current = null;
    activePointerIdRef.current = null;
    activeNoteIdRef.current = null;
    if (completedStroke?.points.length && completedNoteId) {
      skipStrokeRenderRef.current = completedStroke.tool === "marker" ? null : completedStroke.id;
      onAddStrokeRef.current(completedNoteId, completedStroke);
    }
  }, []);

  useLayoutEffect(() => {
    const pointerId = activePointerIdRef.current;
    const canvas = canvasRef.current;
    const completedStroke = activeStrokeRef.current;
    const completedNoteId = activeNoteIdRef.current;
    activePointerIdRef.current = null;
    activeStrokeRef.current = null;
    activeNoteIdRef.current = null;
    if (pointerId !== null && canvas?.hasPointerCapture(pointerId)) {
      canvas.releasePointerCapture(pointerId);
    }
    skipStrokeRenderRef.current = null;
    if (completedStroke?.points.length && completedNoteId) {
      onAddStrokeRef.current(completedNoteId, completedStroke);
    }
    redraw();
  }, [canvasRef, noteId, redraw]);

  useLayoutEffect(() => () => {
    const pointerId = activePointerIdRef.current;
    const canvas = canvasRef.current;
    const completedStroke = activeStrokeRef.current;
    const completedNoteId = activeNoteIdRef.current;
    activePointerIdRef.current = null;
    activeStrokeRef.current = null;
    activeNoteIdRef.current = null;
    if (pointerId !== null && canvas?.hasPointerCapture(pointerId)) {
      canvas.releasePointerCapture(pointerId);
    }
    if (completedStroke?.points.length && completedNoteId) {
      onAddStrokeRef.current(completedNoteId, completedStroke);
    }
  }, [canvasRef]);

  return (
    <canvas
      ref={canvasRef}
      className="ink-canvas"
      style={{
        ...canvasStyle,
        touchAction: penOnly ? "pan-x pan-y pinch-zoom" : "none",
      }}
      data-note-id={noteId}
      aria-label="مساحة الكتابة والرسم"
      onContextMenu={(event) => event.preventDefault()}
      onPointerDown={startStroke}
      onPointerMove={continueStroke}
      onPointerUp={finishStroke}
      onPointerCancel={cancelStroke}
      onLostPointerCapture={cancelStroke}
    />
  );
}

export function DrawingPreview({ strokes, legacyDrawing, className }: DrawingPreviewProps) {
  const { canvasRef } = useCanvasRenderer(strokes, legacyDrawing);
  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ ...canvasStyle, aspectRatio: `${LOGICAL_PAGE_WIDTH} / ${LOGICAL_PAGE_HEIGHT}` }}
      aria-label="معاينة الرسم"
    />
  );
}

function loadPreviewImage(source: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = source;
  });
}

export async function createDrawingPreviewBase64(strokes: Stroke[], legacyDrawing?: string) {
  const width = 900;
  const height = 600;
  const drawingLayer = document.createElement("canvas");
  drawingLayer.width = width;
  drawingLayer.height = height;
  const drawingContext = drawingLayer.getContext("2d");
  if (!drawingContext) throw new Error("تعذّر إنشاء معاينة الكتابة");
  drawingContext.setTransform(width / LOGICAL_PAGE_WIDTH, 0, 0, height / LOGICAL_PAGE_HEIGHT, 0, 0);
  if (legacyDrawing) {
    const legacyImage = await loadPreviewImage(legacyDrawing);
    if (legacyImage) drawingContext.drawImage(legacyImage, 0, 0, LOGICAL_PAGE_WIDTH, LOGICAL_PAGE_HEIGHT);
  }
  for (const stroke of strokes) drawStroke(drawingContext, stroke);

  const output = document.createElement("canvas");
  output.width = width;
  output.height = height;
  const outputContext = output.getContext("2d");
  if (!outputContext) throw new Error("تعذّر تجهيز معاينة الكتابة");
  outputContext.fillStyle = "#ffffff";
  outputContext.fillRect(0, 0, width, height);
  outputContext.drawImage(drawingLayer, 0, 0);
  const dataUrl = output.toDataURL("image/webp", 0.76);
  const separator = dataUrl.indexOf(",");
  if (separator < 0) throw new Error("تعذّر ترميز معاينة الكتابة");
  return dataUrl.slice(separator + 1);
}
