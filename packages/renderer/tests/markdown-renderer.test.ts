import { describe, it, expect, afterEach } from 'vitest';
import {
  renderRichMarkdown,
  renderLatexToMathMl,
  renderMermaidSvg,
  escapeHtml,
} from '../src/markdown-renderer.js';

describe('markdown-renderer', () => {
  afterEach(() => {
    delete (globalThis as any).mermaid;
  });

  describe('escapeHtml', () => {
    it('escapes HTML special characters', () => {
      expect(escapeHtml(`<script attr="a" b='c'>&`)).toBe(
        '&lt;script attr=&quot;a&quot; b=&#39;c&#39;&gt;&amp;',
      );
    });
  });

  describe('renderLatexToMathMl', () => {
    it('renders inline math expressions with fractions, roots, scripts, and symbols', () => {
      const mathml = renderLatexToMathMl(
        String.raw`\frac{\alpha + \beta}{\sqrt{x_i^2 + y^3_0}} \le \infty`,
        false,
      );
      expect(mathml).toContain('display="inline"');
      expect(mathml).toContain('<mfrac>');
      expect(mathml).toContain('<msqrt>');
      expect(mathml).toContain('<msubsup>');
      expect(mathml).toContain('α');
      expect(mathml).toContain('β');
      expect(mathml).toContain('≤');
      expect(mathml).toContain('∞');
    });

    it('renders display math with text, bold, left/right, escaped braces, and matrix environments', () => {
      const pmat = renderLatexToMathMl(
        String.raw`\left\{ \mathbf{A} \text{ cost } \, \begin{pmatrix} 1 & 2 \\ 3 & 4 \end{pmatrix} \right\}`,
        true,
      );
      expect(pmat).toContain('<div class="a2ui-math-block">');
      expect(pmat).toContain('display="block"');
      expect(pmat).toContain('<mstyle mathvariant="bold">');
      expect(pmat).toContain('<mtext> cost </mtext>');
      expect(pmat).toContain('<mtable><mtr><mtd><mn>1</mn></mtd><mtd><mn>2</mn></mtd></mtr>');

      const bmat = renderLatexToMathMl(
        String.raw`\begin{bmatrix} a & b \end{bmatrix} + \begin{matrix} c \end{matrix}`,
        false,
      );
      expect(bmat).toContain('<mo>[</mo><mtable>');
    });

    it('handles unbraced command arguments, trailing slashes, and unknown commands safely', () => {
      const out = renderLatexToMathMl(String.raw`\frac 1 2 + \customcmd + x_ + y^ + \ `, false);
      expect(out).toContain('<mfrac><mrow><mn>1</mn></mrow><mrow><mn>2</mn></mrow></mfrac>');
      expect(out).toContain('<mi>customcmd</mi>');
    });
  });

  describe('renderMermaidSvg', () => {
    it('renders flowchart LR and TD diagrams with rect, round, and diamond nodes plus edge labels', () => {
      const svg = renderMermaidSvg(`
        flowchart LR
          %% comment line
          A["Option A"] -->|fast| B(Process)
          B -- check --> C{Decision}
          C -.-> D
      `);
      expect(svg).toContain('<svg class="a2ui-mermaid-svg"');
      expect(svg).toContain('Option A');
      expect(svg).toContain('Process');
      expect(svg).toContain('Decision');
      expect(svg).toContain('<polygon');
      expect(svg).toContain('stroke-dasharray="4 3"');
      expect(svg).toContain('fast');
      expect(svg).toContain('check');
    });

    it('renders sequenceDiagram definitions with participants and messages', () => {
      const svg = renderMermaidSvg(`
        sequenceDiagram
          participant U as User
          participant S as Sidecar
          U->>S: POST /api/action
          S-->>U: 200 OK
          S->>T: Forward
      `);
      expect(svg).toContain('<svg class="a2ui-mermaid-svg"');
      expect(svg).toContain('User');
      expect(svg).toContain('Sidecar');
      expect(svg).toContain('POST /api/action');
      expect(svg).toContain('200 OK');
    });

    it('falls back to escaped <pre> block for unknown or empty diagram types', () => {
      const unknown = renderMermaidSvg('pie title Pets\n  "Dogs" : 386');
      expect(unknown).toContain('<pre class="a2ui-mermaid-fallback"><code>');
      expect(unknown).toContain('pie title Pets');

      const emptyFlow = renderMermaidSvg('flowchart TD\n  %% only comments');
      expect(emptyFlow).toContain('<pre class="a2ui-mermaid-fallback">');

      const emptySeq = renderMermaidSvg('sequenceDiagram\n  %% only comments');
      expect(emptySeq).toContain('<pre class="a2ui-mermaid-fallback">');
    });
  });

  describe('renderRichMarkdown', () => {
    it('returns empty string for empty input', async () => {
      expect(await renderRichMarkdown('')).toBe('');
    });

    it('renders standard markdown, inline/block math, and mermaid diagrams together', async () => {
      const md = [
        '**Complexity**: $O(N \\log N)$ and \\(\\alpha_1\\).',
        '',
        '$$E = mc^2$$',
        '',
        '\\[x = \\frac{1}{2}\\]',
        '',
        '```mermaid',
        'flowchart TD',
        '  Start --> Stop',
        '```',
      ].join('\n');

      const html = await renderRichMarkdown(md, {
        tagClassMap: { strong: ['custom-strong'] },
      });
      expect(html).toContain('class="custom-strong"');
      expect(html).toContain('<math xmlns="http://www.w3.org/1998/Math/MathML" display="inline">');
      expect(html).toContain('<div class="a2ui-math-block">');
      expect(html).toContain('<svg class="a2ui-mermaid-svg"');
      expect(html).not.toContain('A2UIFRAGMENT');
    });

    it('does not parse $ signs inside inline code spans or non-mermaid code fences', async () => {
      const md = [
        'Use `$HOME` and `$PATH` in shell:',
        '',
        '```bash',
        'echo "$USER" "$HOME"',
        '```',
      ].join('\n');

      const html = await renderRichMarkdown(md);
      expect(html).not.toContain('<math');
      expect(html).toContain('$HOME');
      expect(html).toContain('$PATH');
      expect(html).toContain('$USER');
    });

    it('supports custom mermaidRenderer and globalThis.mermaid with XSS sanitization and error fallback', async () => {
      const htmlCustom = await renderRichMarkdown('```mermaid\nflowchart LR\n  A --> B\n```', {
        mermaidRenderer: () =>
          '<svg onload="alert(1)"><script>evil()</script><a href="javascript:evil()"><text>CustomSVG</text></a></svg>',
      });
      expect(htmlCustom).toContain('CustomSVG');
      expect(htmlCustom).not.toContain('<script>');
      expect(htmlCustom).not.toContain('onload=');
      expect(htmlCustom).not.toContain('javascript:');

      const htmlFallback = await renderRichMarkdown('```mermaid\nflowchart LR\n  A --> B\n```', {
        mermaidRenderer: () => {
          throw new Error('render failed');
        },
      });
      expect(htmlFallback).toContain('<svg class="a2ui-mermaid-svg"');

      (globalThis as any).mermaid = {
        render: async (_id: string, _code: string) => ({
          svg: '<svg><text>GlobalMermaid</text></svg>',
        }),
      };
      const htmlGlobal = await renderRichMarkdown('```mermaid\nflowchart LR\n  A --> B\n```');
      expect(htmlGlobal).toContain('GlobalMermaid');
    });
  });
});
