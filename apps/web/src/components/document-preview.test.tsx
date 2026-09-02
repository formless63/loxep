import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { DocumentPreview } from './document-preview';

describe('DocumentPreview PDF security boundary', () => {
  test('sandboxes untrusted PDFs and keeps explicit open and download fallbacks', () => {
    const servingUrl = '/api/media/document/00000000-0000-4000-8000-000000000000';
    const markup = renderToStaticMarkup(
      <DocumentPreview mimeType='application/pdf' servingUrl={servingUrl} alt='receipt.pdf' />
    );

    expect(markup).toContain(`src="${servingUrl}"`);
    expect(markup).toContain('sandbox=""');
    expect(markup).toContain('Open PDF in a new tab');
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noreferrer"');
    expect(markup).toContain('Download PDF');
    expect(markup).toContain('download="receipt.pdf"');
  });
});
