export { createProcessor, type ActionHandler } from './processor.js';
export { LineApplier, type LineApplyError, type ResetListener } from './line-applier.js';
export {
  A2uiPaneView,
  type SurfaceChangedDetail,
  type SurfaceSubmissionChangedDetail,
  type SurfaceDismissedDetail,
} from './a2ui-pane-view.js';
export {
  renderRichMarkdown,
  renderLatexToMathMl,
  renderMermaidSvg,
  escapeHtml,
  type RichMarkdownOptions,
} from './markdown-renderer.js';
export {
  ICON_SVG_PATHS,
  resolveIconSvgPath,
  installIconSvgRenderer,
  installRichTextVariantRenderer,
} from './icon-paths.js';
export { A2uiChartElement, type ChartResolvedProps } from './a2ui-chart.js';
export {
  CHARTS_CATALOG_ID,
  ChartApi,
  ChartPointSchema,
  ChartSeriesSchema,
  DynamicChartSeriesListSchema,
  A2uiChart,
  chartsCatalog,
  chartsSchemaCatalog,
} from './charts-catalog.js';
export {
  type ChartVariant,
  type ChartScatterPoint,
  type ChartPointInput,
  type ChartSeriesInput,
  type NormalizedPoint,
  type NormalizedSeries,
  type ChartSelection,
  type NiceScale,
  DEFAULT_CHART_COLORS,
  resolveSeriesColor,
  formatTickNumber,
  computeNiceTicks,
  polarToCartesian,
  describeSectorPath,
  normalizeChartSeries,
} from './chart-math.js';
