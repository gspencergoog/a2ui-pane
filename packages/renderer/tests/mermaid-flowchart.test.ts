import { describe, expect, it } from 'vitest';
import {
  parseFlowchartLines,
  parseStateDiagramLines,
  renderFlowchartGraphSvg,
  wrapNodeLabel,
} from '../src/mermaid-flowchart.js';

const REPRO_V1_AT_PREFIXED_LINES = `
    subgraph W1["Wave 1: Shared Core Conformance Fixtures [Sequential]"]
        S1["Pre-1.0 property & v1.0 dual-read YAML cases (PR 1 base)"]
    end
    subgraph W2["Wave 2: Core & Renderer Dual-Read [Parallel]"]
        T2A["Track 2A: TS web_core & web adapters"]
        T2B["Track 2B: Python a2ui_core"]
        T2C["Track 2C: Dart a2ui_core & a2ui_flutter"]
        T2D["Track 2D: Swift A2UICore & A2UISwiftUI"]
        V2["Wave 2 Verifier & PR 1 Gate"]
        T2A -.-> V2
        T2B -.-> V2
        T2C -.-> V2
        T2D -.-> V2
    end
    subgraph W3["Wave 3: v1.0 Spec, Catalogs & Codegen [Sequential]"]
        S3["common_types.json, basic/v1, & SDK schema codegen (PR 2 base)"]
    end
    subgraph W4["Wave 4: Agent SDKs New-Emit & Docs [Parallel]"]
        T4A["Track 4A: Python a2ui_agent"]
        T4B["Track 4B: TS @a2ui/agent"]
        T4C["Track 4C: Dart a2ui_agent & a2ui_cli"]
        T4D["Track 4D: Conformance, Blueprints & Docs"]
        V4["Wave 4 Verifier & PR 2 Gate"]
        T4A -.-> V4
        T4B -.-> V4
        T4C -.-> V4
        T4D -.-> V4
    end
    subgraph W5["Wave 5: Google3 Roll & Local Sync [Sequential]"]
        S5["Roll //third_party/a2ui, abandon cl/1013142453, sync a2ui-pane"]
    end
    subgraph W6["Wave 6: Drop Legacy v1.0 Bare Fallback [Sequential]"]
        S6["Remove v1.0 bare-key shims across SDKs (PR 3)"]
    end
    W1 --> W2 --> W3 --> W4 --> W5 --> W6
`
  .trim()
  .split('\n');

describe('mermaid-flowchart', () => {
  describe('wrapNodeLabel', () => {
    it('splits explicit <br/> tags and word-wraps long lines with ellipsis past maxLines', () => {
      const lines = wrapNodeLabel(
        'Wave 2: Core & Renderer<br/>Dual-Read across TS, Python, Dart, and Swift SDKs',
        24,
        3,
      );
      expect(lines).toHaveLength(3);
      expect(lines[0]).toBe('Wave 2: Core & Renderer');
      expect(lines[2].endsWith('…')).toBe(true);
      for (const line of lines) {
        expect(line.length).toBeLessThanOrEqual(24);
      }
    });

    it('breaks unbroken long identifiers so box widths never overflow', () => {
      const lines = wrapNodeLabel('common_types_json_basic_v1_schema_codegen_pipeline', 20, 3);
      expect(lines).toHaveLength(3);
      expect(lines.every((l) => l.length <= 20)).toBe(true);
    });
  });

  describe('parseFlowchartLines', () => {
    it('expands chained arrows and & multi-node lists without splitting arrows inside quoted labels', () => {
      const parsed = parseFlowchartLines([
        'A["map A --> B"] & B(["Start"]) --> C[["Sub"]] & D{"Check?"} -.->|yes| E',
      ]);
      expect(parsed.nodes.get('A')?.label).toBe('map A --> B');
      expect(parsed.nodes.get('B')?.shape).toBe('round');
      expect(parsed.nodes.get('C')?.shape).toBe('rect');
      expect(parsed.nodes.get('D')?.shape).toBe('diamond');
      expect(parsed.edges).toEqual([
        { from: 'A', to: 'C', label: undefined, dashed: false },
        { from: 'A', to: 'D', label: undefined, dashed: false },
        { from: 'B', to: 'C', label: undefined, dashed: false },
        { from: 'B', to: 'D', label: undefined, dashed: false },
        { from: 'C', to: 'E', label: 'yes', dashed: true },
        { from: 'D', to: 'E', label: 'yes', dashed: true },
      ]);
    });

    it('recovers unclosed subgraphs at EOF and converts empty subgraphs into nodes', () => {
      const parsed = parseFlowchartLines([
        'subgraph Empty["Wave 1: Empty"]',
        'end',
        'subgraph Open["Wave 2 · Parallel (Verifier · PR 1)"]',
        '  T2A["2A · Renderer"]',
        '  T2B["2B · Parser"]',
        'Empty --> Open',
      ]);
      expect(parsed.nodes.get('Empty')?.label).toBe('Wave 1: Empty');
      expect(parsed.subgraphs).toHaveLength(1);
      expect(parsed.subgraphs[0]).toMatchObject({
        id: 'Open',
        title: 'Wave 2 · Parallel',
        caption: 'Verifier · PR 1',
        nodeIds: ['T2A', 'T2B'],
      });
    });
  });

  describe('renderFlowchartGraphSvg', () => {
    it('renders the 6-wave A2UI v1.0 reproduction block within <= 480px width and 6 ordered wave Y-positions', () => {
      const parsed = parseFlowchartLines(REPRO_V1_AT_PREFIXED_LINES);
      const html = renderFlowchartGraphSvg(parsed, 'TD', REPRO_V1_AT_PREFIXED_LINES);

      const viewBoxMatch = /viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/.exec(html);
      expect(viewBoxMatch).not.toBeNull();
      const width = Number(viewBoxMatch![1]);
      const height = Number(viewBoxMatch![2]);
      expect(width).toBeLessThanOrEqual(480);
      expect(height).toBeGreaterThan(500);
      expect(html).not.toContain('max-height:300px');
      expect(html).toContain('<tspan');

      // Zero mangled "-->" arrow tokens inside rendered text
      const textContents = Array.from(
        html.matchAll(/<(?:text|tspan)[^>]*>([^<]*)<\/(?:text|tspan)>/g),
      ).map((m) => m[1]);
      expect(textContents.some((t) => t.includes('--&gt;') || t.includes('-->'))).toBe(false);

      // Verify all 6 wave subgraphs render in strictly ascending Y order
      const sgYs = ['W1', 'W2', 'W3', 'W4', 'W5', 'W6'].map((id) => {
        const m = new RegExp(`data-subgraph-id="${id}"><rect x="[^"]+" y="([^"]+)"`).exec(html);
        expect(m).not.toBeNull();
        return Number(m![1]);
      });
      for (let i = 1; i < sgYs.length; i++) {
        expect(sgYs[i]).toBeGreaterThan(sgYs[i - 1]);
      }
    });

    it('preserves LR for short 2-edge pipelines and auto-flips LR to TD at maxRank >= 3 or with subgraphs', () => {
      const shortLines = ['A["Step 1"] --> B["Step 2"] --> C["Step 3"]'];
      const shortHtml = renderFlowchartGraphSvg(parseFlowchartLines(shortLines), 'LR', shortLines);
      expect(shortHtml).toContain('max-height:200px;');

      const deepLines = ['W1 --> W2 --> W3 --> W4'];
      const deepHtml = renderFlowchartGraphSvg(parseFlowchartLines(deepLines), 'LR', deepLines);
      expect(deepHtml).not.toContain('max-height:200px;');
    });

    it('stamps data-natural-width and min-width floor when viewBox width exceeds 420px', () => {
      const wideLines = [
        'Start --> A["First parallel component"] & B["Second parallel component"] & C["Third parallel component"]',
      ];
      const html = renderFlowchartGraphSvg(parseFlowchartLines(wideLines), 'TD', wideLines);
      const naturalMatch = /data-natural-width="(\d+)"/.exec(html);
      expect(naturalMatch).not.toBeNull();
      const naturalW = Number(naturalMatch![1]);
      expect(naturalW).toBeGreaterThan(420);
      expect(html).toContain(`min-width:${Math.round(naturalW * 0.78)}px;`);
    });

    it('falls back to escaped <pre> block when 0 nodes are parsed and escapes XSS labels', () => {
      const emptyHtml = renderFlowchartGraphSvg(parseFlowchartLines([]), 'TD', ['%% empty']);
      expect(emptyHtml).toContain('class="a2ui-mermaid-fallback"');

      const xssLines = ['A["<img src=x onerror=alert(1)>"] --> B["ok"]'];
      const xssHtml = renderFlowchartGraphSvg(parseFlowchartLines(xssLines), 'TD', xssLines);
      expect(xssHtml).not.toContain('<img');
      expect(xssHtml).toContain('&lt;img');
    });

    it('renders stateDiagram-v2 start and end bullseyes cleanly', () => {
      const stateLines = ['[*] --> Active', 'Active --> [*] : done'];
      const parsed = parseStateDiagramLines(stateLines);
      const html = renderFlowchartGraphSvg(parsed, parsed.direction ?? 'TD', stateLines);
      expect(html).toContain('<circle');
      expect(html).toContain('done');
    });
  });
});
